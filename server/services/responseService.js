/**
 * Service to format structured response payloads for Android & Web client
 */
export class ResponseService {
    /**
     * Build structured response object
     */
    static buildResponse({ mode, intent, rawText, sources = [], reasoning = "" }) {
        let reply = rawText || "";
        let explanation = "";
        let importantNote = "";

        // Extract explanation or notes if structured sections exist in text
        if (reply.includes("Explanation:") || reply.includes("Important Note:") || reply.includes("Important Clarification:")) {
            const expMatch = reply.match(/(?:Explanation|What this means):\s*([\s\S]*?)(?=\n\n(?:Important|Sources|$))/i);
            if (expMatch) explanation = expMatch[1].trim();

            const noteMatch = reply.match(/(?:Important Note|Important Clarification|Limitations):\s*([\s\S]*?)(?=\n\n(?:Sources|$))/i);
            if (noteMatch) importantNote = noteMatch[1].trim();
        }

        // Format sources metadata cleanly
        const formattedSources = Array.isArray(sources)
            ? sources.map((s) => ({
                  title: s.title || "Web Source",
                  url: s.url || "",
                  domain: s.domain || "web",
                  sourceType: s.sourceType || "unknown",
                  publicationDate: s.publicationDate || null
              }))
            : [];

        return {
            success: true,
            mode: mode, // 'search' | 'tutor' | 'mixed' | 'ambiguous'
            intent: intent,
            answer: reply, // For existing frontend compatibility
            reply: reply,   // For prompt specification compatibility
            explanation: explanation,
            importantNote: importantNote,
            sources: formattedSources,
            error: null
        };
    }

    /**
     * Build standard error response
     */
    static buildErrorResponse(errorMessage, statusCode = 500) {
        return {
            statusCode,
            payload: {
                success: false,
                mode: "error",
                intent: "ERROR",
                answer: null,
                reply: null,
                explanation: "",
                importantNote: "",
                sources: [],
                error: errorMessage,
                message: errorMessage
            }
        };
    }
}
